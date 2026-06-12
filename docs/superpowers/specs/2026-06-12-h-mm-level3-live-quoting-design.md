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
  aumentaría (sin pricing-skew continuo en v1); **volatility pause** — si
  |Δmid| en la ventana reciente supera umbral, retirar ambos lados (el riesgo
  dominante son jumps por noticias; el umbral se aprende en shadow de la curva
  retained vs volatilidad previa, default conservador en live).
- **Salida de inventario (`exit_improve`):** el lado que reduce inventario se
  mantiene quotado siempre que sea elegible (prioridad de salida); si el
  inventario del mercado supera el soft-cap, ese lado puede **mejorar el touch
  1 tick** (nunca cruzar el spread). Es el mecanismo activo de realización del
  spread — sin él, en flujo direccional el inventario se acumula y el retained
  medido nunca se convierte en caja. Cohorte etiquetada `exit_improve`,
  medible por separado en shadow (no está en la medición offline).
- **Umbral de spread: aprendido, no hardcodeado.** En shadow se quota todo y se
  mide retained por banda de spread; `MM_MIN_SPREAD_CENTS` para live se fija en
  el gate con esa curva. (Motivado por la auditoría 2026-06-12: el retained se
  concentra en spreads anchos.)
- **Tamaño:** `max(rewardsMinSize, MM_QUOTE_SIZE=20 shares)` — el shadow simula
  el tamaño que el live usaría para que la cola simulada sea la real.
- **Re-quote con histéresis:** cancel/replace solo por price-out o por salida
  de banda rewards; nunca por cambios de tamaño del touch. Cada replace resetea
  la cola. Intervalo mínimo entre replaces por token (default 1s).
- **Rewards:** la elegibilidad (two-sided, en banda, ≥minSize) se evalúa por
  minuto **en memoria** y se persiste agregada — 1 fila por mercado/hora (o por
  cambio de estado), no por minuto (45 mercados × 1440 min ≈ 65k filas/día
  hundiría la TimescaleDB de la e2-micro). Subsidio devengado estimado con
  `mm_reward_snapshots`; el modelo de reparto se sustituye por el de H-MM-2
  cuando haya verdict.

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
  inventario se aplican en shadow igual que en live (retirada de lado y
  `exit_improve` incluidos). PnL sombra descompuesto: spread capturado +
  Δ inventario + rewards estimados. El inventario es el riesgo que el offline
  no midió.
- **Round-trip completion** como métrica de primera clase: por mercado,
  fracción del inventario que rota (fill bid emparejado con fill ask) y tiempo
  medio bid-fill→ask-fill. El retained es proxy de entrada; el beneficio solo
  se realiza cuando el inventario rota. Esta métrica decide el subset live.
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
2. H-MM-4 PASS en la cohorte objetivo, con ambos drain bounds coherentes — y
   **distribución, no solo media**: p5 del retained revisado (cola de jumps),
   no basta el bootstrap de la media.
3. Proyección publicada de fills/día y PnL/día, **descompuesta en
   PnL-spread vs PnL-rewards** (con rates de hasta $117/día, el subsidio puede
   dominar los ~$1–3/día del spread) → decisión de capital con datos (defaults
   de prueba $100 notional / $50 max loss).
4. **Selección del subset live con criterios explícitos por mercado**: retained
   positivo en su banda de spread + round-trip completion demostrada + programa
   de rewards activo + volatilidad dentro del umbral aprendido.
5. Churn de replaces dentro del rate budget del CLOB.
6. Wallet dedicada + GCP Secret Manager + USDC listos (pre-reqs compartidos con
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

## Operativa e infra

- Misma imagen Docker mm-recorder; activar shadow = cambio de env en compose
  **por PR** (nunca edición directa en la VM — rompe el `git pull` del deploy,
  gotcha conocido) + restart.
- Stats horarias al log: quotes activas, fills, inventario, PnL, elegibilidad.
- **Key de wallet: fetch de GCP Secret Manager al boot** vía IAM del service
  account de la VM. Nunca en compose env ni en imagen.
- **Watchdog**: lee `mm_quoter_state` (kill switch, modo) y, en live, alerta de
  staleness si no hay renovación GTD en >2×TTL (parada silenciosa: sin riesgo
  gracias a GTD, pero el quoter dejó de quotar).
- **Supuesto de CPU explícito**: el quoter no es HFT — join-the-touch con
  histéresis y TTL tolera latencias de segundos. Los picos del optimizer en la
  VM (250%+ observados) retrasan re-quotes, no generan riesgo: las GTD expiran
  solas y el volatility pause cierra el hueco de quotes stale.
- Presupuesto de escritura DB: fills sombra (cientos/día) + elegibilidad
  agregada (~45×24 filas/día) + estado — trivial para la TimescaleDB local.

## Testing (TDD)

- **QuotePolicy**: unitarios por guard (incl. volatility pause) + modos
  `rewards_constrained` y `exit_improve` (función pura).
- **Identidad shadow↔live**: el mismo QuotePolicy alimenta ambos; test de que
  con idéntico input producen idéntica quote deseada — es lo que garantiza que
  el shadow predice al live.
- **ShadowLedger**: matriz direccional sintética — precio moviéndose entre
  colocación y fill, BUY/SELL × profit/adverse (la clase de bug del re-pricing
  fantasma); fills parciales; price-out; TTL churn (con reloj mockeado); ambos
  drain counters; gaps; **eventos fuera de orden** (jitter del WS → resultado
  determinista).
- **Invariantes del ledger** (property-style sobre secuencias generadas):
  `queue_ahead` nunca negativa tras reset; tiempo-a-fill con
  `drain_with_cancels` ≤ `drain_trades_only`; inventario = Σ fills con signo.
- **Módulo PnL con invariantes contables** (historial de bugs de signo del
  proyecto): cash + M2M inventario = PnL total; round-trip completo a precios
  `p_bid < p_ask` ⇒ realized = `(p_ask − p_bid) × size` exacto.
- **OrderGateway**: mock del clob-client (post/cancel/renovación GTD con reloj
  mockeado); smoke dry-run manual en VM antes del gate.
- **RiskGuard**: cada límite dispara kill; cancel-all en SIGTERM; **kill switch
  end-to-end sintético** — violación de `MM_MAX_CUM_LOSS` ⇒ modo off persistido
  en `mm_quoter_state`.
- **Integración**: replay determinista de un día real de
  `mm_book_events`/`mm_trade_events` como fixture de regresión del shadow, con
  snapshot de fills esperados committeado.

## Fuera de alcance (v1)

- Pricing-skew continuo por inventario (solo retirada de lado + `exit_improve`
  de 1 tick).
- Auto-flatten del inventario en kill.
- Fair-value model propio (quotamos relativo al book, no a un fair teórico).
- Reconciliación de órdenes órfanas (cancel-all al arrancar).
- Ampliación del universo más allá del recorder (N=45).

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| RAM en e2-micro | Mismo proceso que el recorder; ledger ligero; límite 120MB vigilado en gate |
| Proceso muere con órdenes vivas | GTD TTL (dead-man's switch) + cancel-all en SIGTERM |
| Adverse selection mayor que lo medido | Caps de inventario + `MM_MAX_CUM_LOSS` + kill switch + volatility pause |
| Jumps por noticias (cola del retained) | Volatility pause + gate sobre p5, no solo media |
| Inventario no rota (flujo direccional) | `exit_improve` + round-trip completion como criterio de gate |
| Resolución contra inventario | Guard near-resolution 24h + cap $20/mercado |
| clob-client drift | Re-validación explícita antes del gate |
| Shadow optimista (cancels) | Dos drain bounds reportados; verdad en fase real |
| Picos de CPU del optimizer | Quoter tolerante a latencia (histéresis + TTL); no HFT |
